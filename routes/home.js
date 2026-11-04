var User = require('../models/user');
var Task = require('../models/task');
var mongoose = require('mongoose');

module.exports = function (router) {

    var homeRoute = router.route('/');

    async function syncTask(taskID, oldUserID, newUserID, newStatus, session) {
        if (oldUserID != "") {
            await removePendingTask(oldUserID, taskID, session)
        }
        if (newUserID != "" && !newStatus) {
            await addPendingTask(newUserID, taskID, session)
        }
    }

    async function assignTask(task, user, session) {
        var old = task.assignedUser
        if (user === null) {
            var id = ""
            var name = "unassigned"
        }
        else {
            var id = user._id
            var name = user.name
        }
        await syncTask(task._id, old, id, task.completed, session);
        task.assignedUser = id;
        task.assignedUserName = name;
        await task.save({ session });
    }

    async function taskFieldVal(body) {
            if ((body.name !== undefined && typeof body.name !== "string") ||
            (body.deadline !== undefined && typeof body.deadline !== "string") ||
            (body.description !== undefined && typeof body.description !== "string") ||
            (body.completed !== undefined && typeof body.completed !== "boolean")) {
                throw httpError(400, "Invalid task field types");
            }
    }

    function validateUserFields(body) {
        if (
            typeof body.name !== "string" || !body.name.trim() ||
            typeof body.email !== "string" || !body.email.trim()
        ) {
            throw httpError(400, "Invalid user information");
        }
    }

    async function handleGet(Model, req, res, defaultLimit) {
        try {
            var where = req.query.where === undefined ? {} : JSON.parse(req.query.where);
            var sort = req.query.sort === undefined ? {} : JSON.parse(req.query.sort);
            var select = req.query.select === undefined ? {} : JSON.parse(req.query.select);
            var skip = req.query.skip === undefined ? 0 : Number(req.query.skip);
            var limit = req.query.limit === undefined ? defaultLimit : Number(req.query.limit);
            if ( !Number.isInteger(skip) || skip < 0 || (limit !== null && (!Number.isInteger(limit) || limit < 0))) {
                return res.status(400).json({
                    message: "Invalid query parameters",
                    data: null
                });
            }

            var count = req.query.count === "true";
            if (count) {
                var cnt = await Model.countDocuments(where)
                return res.status(200).json({
                    message: "OK",
                    data: cnt
                })
            }

            var q = Model.find(where)
            q.sort(sort).select(select).skip(skip);
            if (limit !== null) {
                q.limit(limit)
            }

            var q_res = await q
            return res.status(200).json({
                message: "OK",
                data: q_res
            })

        }

        catch (e) {
            if (e instanceof SyntaxError) {
                return res.status(400).json({
                    message: "Invalid JSON query parameter",
                    data: null
                });
            }

            return res.status(500).json({
                message: "Internal server error",
                data: null
            });
        }
    }

    async function handleGetId(Model, req, res) {
        try {
            var select = await req.query.select === undefined ? {} : JSON.parse(req.query.select);
            var q_res = await Model.findById(req.params.id).select(select)
            if (q_res) {
                return res.status(200).json({
                    message: "OK",
                    data: q_res
                })
            }
            else {
                return res.status(404).json({
                    message: "Object doesn't exist",
                    data: null
                })
            }
        }

        catch (e) {
            if (e.name === "SyntaxError") {
                return res.status(400).json({
                    message: "Invalid JSON query parameter",
                    data: null
                });
            }
            else if (e.name === "CastError") {
                return res.status(404).json({
                    message: "Invalid ID format",
                    data: null
                });
            }
            else {
                return res.status(500).json({
                    message: "Internal server error",
                    data: null
                });
            }
        }
    }

    function httpError(status, message) {
    return Object.assign(new Error(message), { status });
        }       

    async function addPendingTask(userID, taskID, session) {
        await User.updateOne({_id: userID}, {$addToSet: {pendingTasks: taskID}}, { session })
    }

    async function removePendingTask(userID, taskID, session) {
        await User.updateOne({_id: userID}, {$pull: {pendingTasks: taskID}}, { session })
    }
    
    async function userVal(userID, userName) {
        if (userID === "" || userID === undefined) {
            if (userName !== undefined && userName !== "unassigned")
                throw httpError(400, "Invalid username");
            return null;
        }
        else if (!mongoose.isObjectIdOrHexString(userID)) {
            throw httpError(400, "Invalid object ID");
        }
        var user = await User.findById(userID)
        if (user === null) {
            throw httpError(404, "User not found")
        }
        if (userName === user.name || userName === undefined) {
            return user
        }
        else {
            throw httpError(400, "Wrong username");
        }
    }

    async function taskVal(taskIDs) {
        if (taskIDs === undefined) {
            return []
        }
        else if (!Array.isArray(taskIDs)) {
            throw httpError(400, "Invalid type for pendingTasks (must be Array)")
        }
        else if (!taskIDs.every(id => mongoose.isObjectIdOrHexString(id))) {
            throw httpError(400, "Invalid task ID");
        }

        var tasks = await Task.find({_id: { $in: taskIDs }});
        var foundIDs = tasks.map(task => String(task._id));
        if (tasks.some(task => task.completed)) {
            throw httpError(400, "Completed task");
        }
        else if (!taskIDs.every(id => foundIDs.includes(id.toLowerCase()))) {
            throw httpError(404, "Task not found");
        }
        else {
            return tasks
        }
    }

    var userRoute = router.route('/users')

    userRoute.get(async function (req, res) {
        handleGet(User, req, res, null)
    })

    userRoute.post(async function (req, res) {
        try {
            var body = req.body || {}
            validateUserFields(body)
            var user = await mongoose.connection.transaction(async (session) =>{
                var user = new User({name: body.name, email: body.email});
                await user.validate();
                var tasks = await taskVal(body.pendingTasks, session);
                await user.save({ session });
                for (var t of tasks) {
                    await assignTask(t, user, session);
                }

                return await User.findById(user._id).session(session);
            })

            return res.status(201).json({
                message: "User created",
                data: user
            });

        }

        catch (e) {
            console.error(e);
            if (e.status) {
                return res.status(e.status).json({
                    message: e.message,
                    data: null
                });
            }
            else if (e.name === "ValidationError" || e.code === 11000) {
                return res.status(400).json({
                message: "Invalid/Duplicate User information",
                data: null
                });
            }
            else {
                return res.status(500).json({
                    message: "Failed to create user",
                    data: null
                });
            }
        }
    })

    var userIdRoute = router.route('/users/:id')
    userIdRoute.get( async function (req, res) {
        handleGetId(User, req, res)
    }) 

    userIdRoute.put( async function (req, res) {
        try {
            if (!mongoose.isObjectIdOrHexString(req.params.id)) {
                throw httpError(404, "Invalid user ID")
            }
            var user = await mongoose.connection.transaction(async (session) => {
                var user = await User.findById(req.params.id).session(session);
                if (user === null) {
                    throw httpError(404, "User does not exist");
                }

                validateUserFields(req.body);
                var tasks = await taskVal(req.body.pendingTasks, session);
                var oldIDs = user.pendingTasks;
                var newIDs = new Set(tasks.map(t => String(t._id)));

                user.name = req.body.name;
                user.email = req.body.email;
                await user.save({ session });
                var oldTasks = await Task.find({ _id: { $in: oldIDs } }).session(session);

                for (var t of oldTasks) {
                    if (!newIDs.has(String(t._id))) {
                        await assignTask(t, null, session);
                    }
                }

                for (var t of tasks) {
                    await assignTask(t, user, session);
                }
                await Task.updateMany( { assignedUser: String(user._id) }, { $set: { assignedUserName: user.name } }, { session });

                return await User.findById(user._id).session(session);
            })

            return res.status(200).json({
                message: "User updated",
                data: user
            })
        }
        catch (e) {
            console.error(e);
            if (e.status) {
                return res.status(e.status).json({
                    message: e.message,
                    data: null
                });
            }
            else if (e.name === "ValidationError" || e.code === 11000) {
                return res.status(400).json({
                message: "Invalid/Duplicate User information",
                data: null
                });
            }
            else {
                return res.status(500).json({
                    message: "Failed to update user",
                    data: null
                });
            }
        }
    })

    userIdRoute.delete(async function (req, res) {
        try {
            if (!mongoose.isObjectIdOrHexString(req.params.id)) {
                throw httpError(404, "Invalid user ID")
            }

            await mongoose.connection.transaction(async (session) => {
                var user = await User.findById(req.params.id).session(session);
                if (user === null) {
                    throw httpError(404, "User does not exist");
                }
                await Task.updateMany({ assignedUser: String(user._id) }, {$set: {assignedUser: "", assignedUserName: "unassigned"}}, { session });
                await user.deleteOne({ session });
            })

            return res.status(204).send();
        }

        catch (e) {
            if (e.status === 404 || e.name === "CastError") {
                return res.status(404).json({
                    message: "Invalid user id or user not found",
                    data: null
                })
            }
            else {
                return res.status(500).json({
                    message: "Internal server error",
                    data: null
                })
            }
        }
    });


    var taskRoute = router.route('/tasks')
    taskRoute.get( async function (req, res) {
        handleGet(Task, req, res, 100)
    })

    taskRoute.post( async function (req, res) {
        try {
            taskFieldVal(req.body);
            var task = new Task({
                name: req.body.name,
                deadline: req.body.deadline,
                description: req.body.description,
                completed: req.body.completed
            });

            await task.validate();

            await mongoose.connection.transaction(async (session) => {
                var user = await userVal(
                    req.body.assignedUser,
                    req.body.assignedUserName,
                    session
                );

                await assignTask(task, user, session);
            });

            return res.status(201).json({
                message: "Task created",
                data: task
            });
        }

        catch (e) {
            var status = e.status || (e.name === "ValidationError" ? 400 : 500)
            return res.status(status).json({
                message: e.status ? e.message : "Invalid task or server error",
                data: null
            });
        }
    })

    var taskIdRoute = router.route('/tasks/:id')
    taskIdRoute.get( async function (req, res) {
        handleGetId(Task, req, res)
    }) 

    taskIdRoute.put( async function (req, res) {
            try {
            if (!mongoose.isObjectIdOrHexString(req.params.id))
                throw httpError(404, "Invalid task ID");

            var task = await mongoose.connection.transaction(async (session) => {
                var task = await Task.findById(req.params.id).session(session);
                if (!task) throw httpError(404, "Task not found");

                var body = req.body || {};
                await taskFieldVal(body);
                task.name = body.name;
                task.deadline = body.deadline;
                task.description = body.description === undefined ? "" : body.description;
                task.completed = body.completed === undefined ? false : body.completed;
                await task.validate();
                var user = await userVal(body.assignedUser, body.assignedUserName, session);
                await assignTask(task, user, session);

                return task;
            });

            return res.status(200).json({ 
                message: "Task updated", 
                data: task 
            });
        }
        catch (e) {
           console.error("PUT /tasks error:", e)
           var status = e.status ||
            (e.name === "ValidationError" || e.name === "CastError" ? 400 : 500);

            return res.status(status).json({
                message: e.status ? e.message :
                    (status === 400 ? "Invalid task information" : "Internal server error"),
                data: null
            });
        }
    })

    taskIdRoute.delete(async function (req, res) {
        try {
            await mongoose.connection.transaction(async (session) => {
                var task = await Task.findById(req.params.id).session(session);
                if (task === null)
                    throw httpError(404, "Task not found");
                await syncTask(task._id, task.assignedUser, "", true, session);
                await task.deleteOne({ session });
            });
            return res.status(204).send()
        }

        catch (e) {
            if (e.status === 404 || e.name === "CastError") {
                return res.status(404).json({
                    message: "missing/invalid task ID",
                    data: null
                })
            }
            else {
                return res.status(500).json({
                    message: "Internal server error",
                    data: null
                })
            }
        }
    });
    return router;
}
